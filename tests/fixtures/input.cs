// POSITIVE FIXTURE: File with common EF6 patterns
// Expected: input == output (mining codemod, read-only, no file changes)

using System.Data.Entity;
using System.Data.Entity.Infrastructure;

namespace MyApp.Data
{
    // ObjectContext subclass - critical blocker
    public class LegacyContext : ObjectContext
    {
        public IObjectSet<Product> Products { get; set; }
    }

    // DbContext with IDbSet<T> - legacy pattern
    public class AppDbContext : DbContext
    {
        public IDbSet<Product> Products { get; set; }
        public IDbSet<Order> Orders { get; set; }
        public DbSet<Customer> Customers { get; set; }

        public void SeedData()
        {
            // ExecuteSqlCommand - critical blocker
            Database.ExecuteSqlCommand("TRUNCATE TABLE Products");

            // SetInitializer - critical blocker
            Database.SetInitializer<AppDbContext>(null);
        }
    }

    // EntityTypeConfiguration - must be ported to IEntityTypeConfiguration<T>
    public class ProductMap : EntityTypeConfiguration<Product>
    {
        public ProductMap()
        {
            ToTable("Products");
            HasKey(t => t.Id);
            Property(t => t.Name).IsRequired().HasMaxLength(256);
        }
    }

    // DbConfiguration - no EF Core equivalent
    public class AppDbConfiguration : DbConfiguration
    {
        public AppDbConfiguration()
        {
            SetExecutionStrategy("System.Data.SqlClient", () => new SqlAzureExecutionStrategy());
        }
    }

    // Virtual navigation properties - lazy loading reliance
    public class Order
    {
        public int Id { get; set; }
        public virtual Customer Customer { get; set; }
        public virtual ICollection<OrderItem> Items { get; set; }
    }
}
