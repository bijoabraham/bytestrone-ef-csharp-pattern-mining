using System.Data.Entity;

namespace Sample.Data
{
    public class StoreContext : DbContext
    {
        public IDbSet<Product> Products { get; set; }
    }

    public class Product
    {
        public int Id { get; set; }
    }
}
